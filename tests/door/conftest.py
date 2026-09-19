from pathlib import Path
from datetime import datetime, timedelta
import csv
import io
import sys
import numpy as np
import pytest
ROOT=Path(__file__).resolve().parents[2]/'backend'
sys.path.insert(0,str(ROOT))
from door.predict import ORIGINAL_HEADERS

@pytest.fixture
def synthetic_csv():
    """Original tiny synthetic test fixture, not a copy of the hackathon data."""
    text=io.StringIO();w=csv.writer(text);w.writerow(ORIGINAL_HEADERS)
    base=datetime(2023,7,5)
    for cycle in range(2):
        for i in range(151):
            p=i/150;position=1000*(p if cycle==0 else 1-p)
            current=400+1100*np.sin(np.pi*p)**2
            stamp=base+timedelta(milliseconds=cycle*20000+i*20)
            native=f'{stamp.year}-{stamp.month}-{stamp.day}-{stamp.hour}-{stamp.minute}-{stamp.second}-{stamp.microsecond//1000}'
            row=[native,current,1500,500,
                 30,30,int(cycle==1),int(cycle==0),0,0,0,0,0,0,int(cycle==0),int(cycle==1),position]
            w.writerow(row)
    return text.getvalue().encode()
